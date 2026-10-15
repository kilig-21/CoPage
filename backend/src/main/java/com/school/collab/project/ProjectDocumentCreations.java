package com.school.collab.project;

import com.school.collab.document.DocumentCreationRequests;
import com.school.collab.document.DocumentService;
import org.springframework.stereotype.Service;

/** 明确新建并加入项目；正文、初始版本、关联和原响应复用同一个创建收据事务。 */
@Service
public class ProjectDocumentCreations {
    private final DocumentCreationRequests creations;
    private final DocumentService documents;
    private final ProjectService projects;

    public ProjectDocumentCreations(DocumentCreationRequests creations,DocumentService documents,ProjectService projects) {
        this.creations=creations;this.documents=documents;this.projects=projects;
    }

    public Created execute(String requestId,long projectId,String title,String templateId) {
        return creations.execute(requestId,"project-document:"+projectId,new Input(title,templateId),Created.class,()->{
            projects.lockForDocumentCreation(projectId);
            var created=documents.create(title,0,templateId);
            if(!projects.add(projectId,created.id()).changed())
                throw new IllegalStateException("新文档无法加入项目");
            return new Created(created.id(),projectId,created.title());
        });
    }

    public record Created(long id,long projectId,String title) implements DocumentCreationRequests.CreatedDocument { }
    private record Input(String title,String templateId) { }
}
